from collections import deque

class Node:
    def __init__(self, MAC:str, neighbors=None):
        self.MAC = MAC
        self.neighbors = set()
        self.cc = {self}
        if neighbors:
            self.add_node(neighbors)
            
    def __repr__(self):
        return f"Node({self.MAC})"

    def add_node(self, neighbors):
        for n in neighbors:
            self.neighbors.add(n)
            n.neighbors.add(self)
            self.cc |= n.cc

        visited = {self}
        q = deque([self])
        while q:
            node = q.popleft()
            visited.add(node)
            node.cc = self.cc
            for n in node.neighbors:
                if n not in visited:
                    q.append(n)


    def remove_node(self):
        nbrs = list(self.neighbors)
        for n in nbrs:
            n.neighbors.discard(self) # disconnect from neighbors
        
        self.neighbors = set()
        self.cc = set()
        visited = set() # recompute CC for each disconnected region

        def recompute_cc(start): # helper
            cc = set()
            q = deque([start])
            visited.add(start)
            while q:
                node = q.popleft()
                cc.add(node)
                for nbr in node.neighbors:
                    if nbr not in visited:
                        visited.add(nbr)
                        q.append(nbr)
            return cc

        for nbr in nbrs:
            if nbr not in visited:
                comp = recompute_cc(nbr)
                for node in comp:
                    node.cc = comp

if __name__ == "__main__":
    n1 = Node("mac1")
    n2 = Node("mac2", neighbors={n1})
