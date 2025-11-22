class Node: 
    def __init__(self, v, el=None):
        self.value = v
        self.neighbors = el

    def set_value(self, v):
        self.value = v

    def get_neighbors(self):
        return self.neighbors

    def set_neighbors(self, el): 
        self.neighbors = el

    


